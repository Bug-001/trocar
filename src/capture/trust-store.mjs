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

// CA subject CN — "/CN=atrace local MITM CA".
export const CA_CN = 'atrace local MITM CA'
// NSS nickname the CA is registered under (Linux).
export const CA_NICKNAME = 'asight-ca'

// Default runner: run a command, capture status/stdout/stderr, NEVER throw on nonzero exit
// (so verify's "cert absent" = status!=0 is data, not an exception).
function defaultRun(file, args) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    return {
      status: e.status ?? 1,
      stdout: e.stdout?.toString?.() ?? '',
      stderr: e.stderr?.toString?.() ?? String((e && e.message) || e),
    }
  }
}

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
    verifyUserTrustOnly() { const a = verifyArgv(); return run(a.file, a.args).status === 0 },
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
    verifyUserTrustOnly() { const a = verifyArgv(); return run(a.file, a.args).status === 0 },
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
