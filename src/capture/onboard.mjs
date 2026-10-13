// onboard.mjs — real cross-platform onboard (D22). Three jobs:
//   1. generate the capture CA + api.anthropic.com leaf (OpenSSL — all platforms),
//   2. install the CA IMPORT-ONLY into the USER-LEVEL trust store (TrustStoreInstaller dispatch),
//   3. steer the CC-CLI harness at the local capture proxy via ~/.claude/settings.json env.
// OBSERVE-only: this only ARRANGES capture; it never originates requests, never touches
// machine-wide TLS trust, and Clash steer (macOS-Desktop only) is intentionally NOT here.
import { execFileSync } from 'node:child_process'
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getTrustStoreInstaller, CA_CN } from './trust-store.mjs'
import { caDir as canonicalCaDir } from '../paths.mjs'

/** The old capture's MITM listens here (D22); the board's 监测 toggle and `asight serve` default to it. */
export const OLD_CAPTURE_PROXY_URL = 'http://127.0.0.1:8899'

// D27 canonical CA home. It MUST equal paths.caDir() so every CA consumer (onboard install,
// leafHosts) resolves the SAME directory — a second dir is how a second same-CN CA came to exist and
// broke every steered TLS handshake on 2026-07-21.
// caDir() already falls back to the legacy ~/.atrace/ca when only that exists, so old installs still
// resolve; fresh ones land in ~/.asight/ca.
export const DEFAULT_CA_DIR = canonicalCaDir()
export const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
// Where `on` stashes the proxy env it displaced, so `off` can hand it back (injectable for tests).
export const DEFAULT_STASH_PATH = path.join(os.homedir(), '.atrace', 'steer-backup.json')
const CA_SUBJECT = `/CN=${CA_CN}/O=atrace`
const LEAF_HOST = 'api.anthropic.com' // the v1 default capture target (4.1:13)

function defaultRun(file, args) {
  execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  return { status: 0 }
}

// Generate root CA (RSA-3072 / 10y) + a leaf for the capture-target host(s) — mirrors
// Keys chmod 0600. Idempotent unless force. Returns the produced paths.
const CA_ARTIFACTS = ['atrace-ca.crt', 'atrace-ca.key', 'leaf.key', 'leaf.crt']
const CA_SPILL = ['leaf.csr', 'leaf.ext', 'atrace-ca.srl'] // byproducts; moved along if present
const HOSTS_FILE = 'leaf.hosts' // records which hosts the leaf in this dir can actually authorize

// Which hosts the leaf in `caDir` authorizes. A dir written before the leaf became host-driven has
// no sidecar — and every such leaf was, by construction, api.anthropic.com-only.
export function leafHosts(caDir = DEFAULT_CA_DIR) {
  try {
    const v = JSON.parse(readFileSync(path.join(caDir, HOSTS_FILE), 'utf8'))
    return Array.isArray(v) ? v : [LEAF_HOST]
  } catch { return [LEAF_HOST] }
}

// `hosts` drives the leaf's CN + SAN. This is load-bearing: TLS rejects the handshake outright
// (ERR_TLS_CERT_ALTNAME_INVALID) when the servername is not in the SAN, so a MITM told to terminate
// some host X needs a leaf generated for X — reusing the anthropic leaf silently breaks every
// connection. 4.1:13 makes the capture-target host configurable, so the leaf follows it.
export function generateCa({ caDir = DEFAULT_CA_DIR, hosts = [LEAF_HOST], force = false, run = defaultRun } = {}) {
  const wanted = (Array.isArray(hosts) ? hosts : [hosts]).filter(Boolean)
  if (!wanted.length) throw new Error('generateCa: `hosts` must name at least one capture-target host')
  const P = (f) => path.join(caDir, f)
  const caCrt = P('atrace-ca.crt'), caKey = P('atrace-ca.key')
  const leafKey = P('leaf.key'), leafCrt = P('leaf.crt')
  const paths = { caDir, caCrt, caKey, leafKey, leafCrt, hosts: wanted }
  // The short-circuit requires ALL FOUR artifacts. ca.crt alone means an earlier run was interrupted
  // (it is written three openssl invocations before leaf.crt) — treating that as "existed" would
  // poison the dir permanently, since leaf.crt would never be created.
  // It ALSO requires the existing leaf to authorize every host asked for; otherwise reuse would hand
  // back a cert the TLS peer rejects.
  const covered = leafHosts(caDir)
  if (!force && CA_ARTIFACTS.every((f) => existsSync(P(f))) && wanted.every((h) => covered.includes(h))) {
    return { ...paths, hosts: covered, existed: true }
  }

  // Build into a staging dir and only move artifacts into place once ALL of them exist, so an
  // interrupted (or failed) regen can never leave a NEW ca.crt beside an OLD leaf.crt that no longer
  // chains to it — a state that looks complete but silently breaks every TLS handshake.
  const stage = `${caDir}.asight-tmp-${process.pid}-${Date.now()}`
  const S = (f) => path.join(stage, f)
  try {
    mkdirSync(stage, { recursive: true, mode: 0o700 })
    run('openssl', ['genrsa', '-out', S('atrace-ca.key'), '3072'])
    run('openssl', ['req', '-x509', '-new', '-nodes', '-key', S('atrace-ca.key'), '-sha256', '-days', '3650', '-subj', CA_SUBJECT, '-out', S('atrace-ca.crt')])
    run('openssl', ['genrsa', '-out', S('leaf.key'), '2048'])
    run('openssl', ['req', '-new', '-key', S('leaf.key'), '-subj', `/CN=${wanted[0]}`, '-out', S('leaf.csr')])
    writeFileSync(S('leaf.ext'), `subjectAltName=${wanted.map((h) => `DNS:${h}`).join(',')}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n`)
    // `-CAserial` names the serial file: without it openssl derives the name from the CA's path, and the system LibreSSL of macOS reads the staging dir's `.asight-tmp-…` as the extension
    // and writes `<HOME>/.srl` — a file outside ~/.asight that no receipt lists and no uninstall removes (audit rule-b 4). CA_SPILL moves the right one along with the rest.
    run('openssl', ['x509', '-req', '-in', S('leaf.csr'), '-CA', S('atrace-ca.crt'), '-CAkey', S('atrace-ca.key'), '-CAserial', S('atrace-ca.srl'), '-CAcreateserial', '-days', '3650', '-sha256', '-extfile', S('leaf.ext'), '-out', S('leaf.crt')])
    for (const f of CA_ARTIFACTS) if (!existsSync(S(f))) throw new Error(`asight CA generation produced no ${f} (openssl failed silently?) — nothing was installed into ${caDir}`)
    writeFileSync(S(HOSTS_FILE), JSON.stringify(wanted) + '\n') // what this leaf can authorize
    for (const k of ['atrace-ca.key', 'leaf.key']) { try { chmodSync(S(k), 0o600) } catch { /* best-effort */ } }
    // Clear the destination first: a crash mid-move then leaves artifacts MISSING (which the
    // all-four gate above heals on the next run) rather than mismatched-but-complete.
    mkdirSync(caDir, { recursive: true, mode: 0o700 })
    for (const f of [...CA_ARTIFACTS, ...CA_SPILL, HOSTS_FILE]) { try { rmSync(P(f), { force: true }) } catch { /* best-effort */ } }
    for (const f of [...CA_ARTIFACTS, ...CA_SPILL, HOSTS_FILE]) if (existsSync(S(f))) renameSync(S(f), P(f))
  } finally {
    try { rmSync(stage, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  return { ...paths, existed: false }
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
// The undo half (readSettings, backupSettingsOnce, STEER_KEYS, readStash, clearCliSteer) sits here beside the write half —
// there is one undo, not two, and `atraceOff` (the web switch's off, src/capture/control.mjs) runs it.
// The user's settings.json is THEIR file (model / permissions / mcpServers live here). A read we cannot fully understand MUST NOT become an empty object we then write back — that silently
// destroys everything in it. Only a genuinely absent file means "start from {}"; every other failure (unparseable JSON, EACCES, a directory, …) THROWS so nothing is written.
function readSettings(p) {
  let raw
  try { raw = readFileSync(p, 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return {} // no file yet → a fresh {} is the honest starting point
    throw new Error(`asight refused to touch ${p}: cannot read it (${e.code || e.message}). Nothing was written — fix or move the file, then retry.`)
  }
  try { return JSON.parse(raw) } catch (e) {
    throw new Error(`asight refused to overwrite ${p}: it is not strict JSON (${e.message}). Comments/trailing commas are not parseable here, and overwriting would destroy your model/permissions/mcpServers. Nothing was written — make it strict JSON (or move it aside), then retry.`)
  }
}

/** Copies the user's pre-steer settings.json to <path>.asight-bak — ONCE, so repeated on/off cycles keep the ORIGINAL (a per-write backup would just archive an already-steered file). */
function backupSettingsOnce(p) {
  const bak = p + '.asight-bak'
  try { if (existsSync(p) && !existsSync(bak)) writeFileSync(bak, readFileSync(p, 'utf8')) } catch { /* best-effort */ }
}

/** The keys the steer OWNS. Anything pre-existing under these names belongs to the user (a corporate proxy, a VPN) and is DISPLACED, not owned — so `on` stashes it and `off` puts it back. Keys absent
 *  from the stash were introduced by asight and are the only ones `off` may delete (零残留 · 4.1:101). */
const STEER_KEYS = ['HTTPS_PROXY', 'NO_PROXY']

/** The env the steer displaced, from the stash file: `{}` when it displaced nothing, null when there is no stash (or it cannot be read). */
function readStash(stashPath) {
  try { return JSON.parse(readFileSync(stashPath, 'utf8')).env || {} } catch { return null }
}

// Stash of what the steer displaced. Written ONCE per on→off cycle: a second `on` must not overwrite
// the user's real values with asight's own. Consumed (deleted) by `off` once restored.
function stashDisplaced(stashPath, env) {
  if (existsSync(stashPath)) return // already hold the pre-steer truth — never clobber it
  const displaced = {}
  for (const k of STEER_KEYS) if (env?.[k] !== undefined) displaced[k] = env[k]
  try {
    mkdirSync(path.dirname(stashPath), { recursive: true })
    writeFileSync(stashPath, JSON.stringify({ settingsPath: null, env: displaced }, null, 2) + '\n')
  } catch { /* best-effort: a missing stash degrades to today's delete-on-off, never blocks capture */ }
}
export function writeCliSteer({ settingsPath = DEFAULT_SETTINGS_PATH, stashPath = DEFAULT_STASH_PATH, proxyUrl }) {
  const s = readSettings(settingsPath) // throws before any write if we can't understand the file
  stashDisplaced(stashPath, s.env) // record what we are about to displace, BEFORE displacing it
  s.env = { ...(s.env || {}), HTTPS_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost' }
  mkdirSync(path.dirname(settingsPath), { recursive: true })
  backupSettingsOnce(settingsPath)
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  return s.env
}
// `restoreProxy` (explicit) > stash (what `on` displaced) > delete (asight introduced it).
// The explicit form is how a caller points HTTPS_PROXY back at the upstream VPN/direct (4.1:61).
export function clearCliSteer({ settingsPath = DEFAULT_SETTINGS_PATH, stashPath = DEFAULT_STASH_PATH, restoreProxy = '' } = {}) {
  const s = readSettings(settingsPath)
  const stash = readStash(stashPath)
  if (s.env) {
    for (const k of STEER_KEYS) {
      if (stash?.[k] !== undefined) s.env[k] = stash[k] // user's own value — put it back verbatim
      else delete s.env[k] // asight introduced it — remove it
    }
    if (restoreProxy) s.env.HTTPS_PROXY = restoreProxy // explicit override beats both
  }
  backupSettingsOnce(settingsPath)
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  if (stash) { try { rmSync(stashPath, { force: true }) } catch { /* best-effort */ } }
  return s.env || {}
}

// One-call onboard: generate CA (if needed) + install into user trust + steer CC-CLI.
// The steer's PRECONDITION is a trusted CA. Steering the harness at a MITM whose CA was never
// installed does not degrade gracefully — every request dies at the TLS handshake, with nothing to
// point at the cause. So a failed install ABORTS before the steer is written, leaving the harness
// exactly as it was (direct). It throws rather than returning ok:false because the caller
// (src/capture/control.mjs `monitoringOn`, behind the board's /control/monitoring) reads the result as an already-succeeded
// onboard; a throw is the only shape it surfaces truthfully.
export function atraceOn({ caDir, proxyUrl = OLD_CAPTURE_PROXY_URL, settingsPath, stashPath, platform, installerOpts, run } = {}) {
  const ca = generateCa({ caDir, run })
  const install = installCa({ caCrt: ca.caCrt, platform, installerOpts })
  // The precondition is "is the CA trusted", NOT "did the installer exit 0". macOS
  // `security add-certificates` exits NON-ZERO when the cert is already in the keychain, so on every
  // already-onboarded machine the SUCCESS path looks like a failure. Aborting on the exit code alone
  // broke `asight on` (and the board's 监测 toggle, which surfaced it as a silent no-op) for exactly
  // the users who had it working. Ask the trust store directly before giving up.
  const trusted = install.ok || (() => {
    try { return !!verifyUserTrustOnly({ platform, installerOpts }) } catch { return false }
  })()
  if (!trusted) {
    const detail = install.result?.stderr?.trim() || install.result?.stdout?.trim() || `exit status ${install.result?.status}`
    const e = new Error(
      `\`monitoring on\` ABORTED: installing the capture CA into the ${install.platform} user trust store FAILED (${detail}). ` +
      `NOTHING was steered — ${settingsPath || DEFAULT_SETTINGS_PATH} is unchanged and the harness still talks to the API directly. ` +
      `The CA itself was generated at ${ca.caCrt}; trust it (or fix the installer) and re-run the board's 监测 toggle. ` +
      `Steering the harness at the capture proxy without a trusted CA would break every request with a TLS error.`,
    )
    e.ca = ca
    e.install = install
    throw e
  }
  const steer = writeCliSteer({ settingsPath, stashPath, proxyUrl })
  return { ca, install, steer }
}
export function atraceOff({ settingsPath, stashPath, restoreProxy, platform, installerOpts, removeCa = false } = {}) {
  const steer = clearCliSteer({ settingsPath, stashPath, restoreProxy })
  const ca = removeCa ? uninstallCa({ platform, installerOpts }) : null
  return { steer, ca }
}
