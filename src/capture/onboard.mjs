// onboard.mjs — real cross-platform onboard (D22 · RFC 4.1 §onboard · 4.5). Three jobs:
//   1. generate the capture CA + api.anthropic.com leaf (OpenSSL — all platforms),
//   2. install the CA IMPORT-ONLY into the USER-LEVEL trust store (TrustStoreInstaller dispatch),
//   3. steer the CC-CLI harness at the local capture proxy via ~/.claude/settings.json env.
// OBSERVE-only: this only ARRANGES capture; it never originates requests, never touches
// machine-wide TLS trust, and Clash steer (macOS-Desktop only) is intentionally NOT here.
import { execFileSync } from 'node:child_process'
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getTrustStoreInstaller, CA_CN } from './trust-store.mjs'

export const DEFAULT_CA_DIR = path.join(os.homedir(), '.atrace', 'ca')
export const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CA_SUBJECT = `/CN=${CA_CN}/O=atrace`
const LEAF_HOST = 'api.anthropic.com'

function defaultRun(file, args) {
  execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  return { status: 0 }
}

// Generate root CA (RSA-3072 / 10y) + api.anthropic.com leaf.
// Keys chmod 0600. Idempotent unless force. Returns the produced paths.
export function generateCa({ caDir = DEFAULT_CA_DIR, force = false, run = defaultRun } = {}) {
  const P = (f) => path.join(caDir, f)
  const caCrt = P('atrace-ca.crt'), caKey = P('atrace-ca.key')
  const leafKey = P('leaf.key'), leafCrt = P('leaf.crt'), leafCsr = P('leaf.csr'), leafExt = P('leaf.ext')
  if (existsSync(caCrt) && !force) return { caDir, caCrt, caKey, leafKey, leafCrt, existed: true }
  mkdirSync(caDir, { recursive: true, mode: 0o700 })
  run('openssl', ['genrsa', '-out', caKey, '3072'])
  run('openssl', ['req', '-x509', '-new', '-nodes', '-key', caKey, '-sha256', '-days', '3650', '-subj', CA_SUBJECT, '-out', caCrt])
  run('openssl', ['genrsa', '-out', leafKey, '2048'])
  run('openssl', ['req', '-new', '-key', leafKey, '-subj', `/CN=${LEAF_HOST}`, '-out', leafCsr])
  writeFileSync(leafExt, `subjectAltName=DNS:${LEAF_HOST}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n`)
  run('openssl', ['x509', '-req', '-in', leafCsr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-days', '3650', '-sha256', '-extfile', leafExt, '-out', leafCrt])
  for (const k of [caKey, leafKey]) { try { chmodSync(k, 0o600) } catch { /* best-effort */ } }
  return { caDir, caCrt, caKey, leafKey, leafCrt, existed: false }
}

// Install the CA import-only into the user-level trust store (per-OS via D22 dispatch).
export function installCa({ caCrt, platform = process.platform, installerOpts = {} } = {}) {
  const inst = getTrustStoreInstaller(platform, installerOpts)
  const result = inst.install(caCrt)
  return { platform: inst.platform, ok: (result?.status ?? 0) === 0, result }
}
export function verifyUserTrustOnly({ platform = process.platform, installerOpts = {} } = {}) {
  return getTrustStoreInstaller(platform, installerOpts).verifyUserTrustOnly()
}
export function uninstallCa({ platform = process.platform, installerOpts = {} } = {}) {
  return getTrustStoreInstaller(platform, installerOpts).uninstall()
}

// ── CC-CLI steer (cross-platform): point the harness at the local capture proxy via
// ~/.claude/settings.json env; atraceOff reverts. No Clash (that is macOS-Desktop only). ──
function readSettings(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} } }

export function writeCliSteer({ settingsPath = DEFAULT_SETTINGS_PATH, proxyUrl }) {
  const s = readSettings(settingsPath)
  s.env = { ...(s.env || {}), HTTPS_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost' }
  mkdirSync(path.dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  return s.env
}
export function clearCliSteer({ settingsPath = DEFAULT_SETTINGS_PATH, restoreProxy = '' } = {}) {
  const s = readSettings(settingsPath)
  if (s.env) {
    if (restoreProxy) s.env.HTTPS_PROXY = restoreProxy; else delete s.env.HTTPS_PROXY
    delete s.env.NO_PROXY
  }
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  return s.env || {}
}

// One-call onboard: generate CA (if needed) + install into user trust + steer CC-CLI.
export function atraceOn({ caDir, proxyUrl = 'http://127.0.0.1:8899', settingsPath, platform, installerOpts, run } = {}) {
  const ca = generateCa({ caDir, run })
  const install = installCa({ caCrt: ca.caCrt, platform, installerOpts })
  const steer = writeCliSteer({ settingsPath, proxyUrl })
  return { ca, install, steer }
}
export function atraceOff({ settingsPath, restoreProxy, platform, installerOpts, removeCa = false } = {}) {
  const steer = clearCliSteer({ settingsPath, restoreProxy })
  const ca = removeCa ? uninstallCa({ platform, installerOpts }) : null
  return { steer, ca }
}
